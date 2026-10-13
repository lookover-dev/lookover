// What fixes a problem the app shows (ADR 0053): a command the service answers, or a page to open, GitHub's for what
// only GitHub can change (an uninstalled App, a new key). The app gives each its label.
import type { Command } from "./command.ts";

export type FixAction = { command: Command } | { href: string };
