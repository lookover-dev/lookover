// The world S8 to S13 play in (ADR 0046): `ledger-api.ts`'s world (its owner, its bot, both engines ready at the
// versions the app shows) on another repository, `sasensi/lookover-sandbox`, with its own base commit. S1 to S7
// play on `LEDGER_API` itself; S14 keeps its own world: its versions and its base are the recordings'.
import { commitSha } from "@lookover/contracts";
import type { World } from "../scenario.ts";
import { LEDGER_API } from "./ledger-api.ts";

export const SANDBOX: World = {
  ...LEDGER_API,
  repo: { owner: "sasensi", name: "lookover-sandbox" },
  main: { ref: "main", sha: commitSha("5a1e9c0d7b2f4e6a8c0d1e2f3a4b5c6d7e8f9a0b") },
};
