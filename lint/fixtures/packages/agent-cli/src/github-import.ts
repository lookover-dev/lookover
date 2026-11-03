// agent-cli never imports github, so it can never hold Lookover's sign-in token (ADR 0021, ADR 0033).
import { createGitHub } from "@lookover/github";

export const github = createGitHub;
