// The shared App, "Lookover Dev" (ADR 0065, ADR 0066): the one App every signed-in person's Lookover posts through.
// It ships as this constant; nothing about it is configured. Its client ID is all the device flow needs: the App
// has no secret Lookover holds.
import type { HostAccount } from "./github-app.ts";

export interface SharedApp {
  /** GitHub's id of the App: its checks are filed under it. */
  id: number;
  /** Its slug: the agent finds its checks by it. */
  slug: string;
  /** The client ID a person signs in with. */
  clientId: string;
  /** The account that owns it. */
  account: Pick<HostAccount, "login" | "type">;
}

export const SHARED_APP = {
  id: 5539293,
  slug: "lookover-dev",
  clientId: "Iv23libbJjCyUUzkZnHc",
  account: { login: "lookover-dev", type: "Organization" },
} as const satisfies SharedApp;
