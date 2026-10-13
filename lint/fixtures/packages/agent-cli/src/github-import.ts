// agent-cli never imports github, so it can never hold the App's key or a token (ADR 0021, ADR 0033).
import { createGitHub } from "@lookover/github";

export const github = createGitHub;
