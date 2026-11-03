// The key scanner (ADR 0053, spec #187 story 33): private-key text in a folder or in given text, for the checks that
// no secret leaks outside the sign-in store's sealed files.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesWithKeyText, hasKeyText } from "./key-scan.test-support.ts";

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

test("a private key's armour is key text, whatever its kind, even escaped in JSON", () => {
  expect(hasKeyText(KEY)).toBe(true);
  expect(hasKeyText("-----BEGIN PRIVATE KEY-----\nabc")).toBe(true);
  expect(hasKeyText("-----BEGIN EC PRIVATE KEY-----")).toBe(true);
  expect(hasKeyText(JSON.stringify({ key: KEY }))).toBe(true);
  expect(hasKeyText("-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----")).toBe(false);
  expect(hasKeyText("the App's key was refused")).toBe(false);
  for (const kind of ["RSA ", "", "EC ", "ENCRYPTED ", "OPENSSH ", "DSA "])
    expect(hasKeyText(`x\n-----BEGIN ${kind}PRIVATE KEY-----\nabc`)).toBe(true);
  for (const text of ["-----BEGIN CERTIFICATE-----", "BEGIN RSA PRIVATE KEY", ""])
    expect(hasKeyText(text)).toBe(false);
});

test("a known key's body is found without its armour, one line of it is enough", () => {
  expect(hasKeyText(`log: ${BODY[1]}`, [KEY])).toBe(true);
  expect(hasKeyText(JSON.stringify({ body: BODY.join("\n") }), [KEY])).toBe(true);
  expect(hasKeyText(`log: ${BODY[1]}`)).toBe(false);
  expect(hasKeyText("log: nothing secret", [KEY])).toBe(false);
});

test("a data folder with no key text has no file found", async () => {
  const home = folder();
  writeFileSync(join(home, "settings.yaml"), "depth: deep\n");
  expect(await filesWithKeyText(home, { known: [KEY] })).toEqual([]);
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
