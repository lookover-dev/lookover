# Security

## Supported versions

| Version | Security fixes |
|---|---|
| The latest 0.x minor | Yes, as a patch release |
| Older versions | No: update to the latest |

## Reporting a vulnerability

Report it privately through GitHub: [**Report a vulnerability**](https://github.com/lookover-dev/lookover/security/advisories/new) (the repository's Security tab). Please never open a public issue for a security flaw.

Include what you can:

- the Lookover version (`lookover --version`), your system, and the `claude` and `codex` versions;
- the steps, or a pull request's content, that show the flaw, with fake secrets;
- what an attacker gains.

You get an answer within 7 days. Once a fix is out, the advisory is published with credit to you, unless you prefer otherwise.

## In scope

- **A pull request that steers the review:** its code, files or comments making the AI write outside its sandbox, run a hook or an MCP server, read a token, or post something Lookover shouldn't.
- **A secret that leaks:** a GitHub token, the App's private key or a subscription's credentials reaching the model, a post on GitHub, the logs or another user of the computer.
- **The service and its app:** anything that reaches them without the one-time link, or acts on another data folder.
- **The packages:** the `lookover` launcher and the `@lookover/*` executables, and how they are built and published.
- **The skill** Lookover installs for Claude Code and Codex.

Out of scope: flaws in the `claude` and `codex` CLIs, GitHub or the AI models themselves (report those to their makers), and findings a review got wrong.

## How Lookover ships

- The npm packages have **no runtime dependencies and no install scripts**: `lookover` is a small Node launcher, and each `@lookover/<platform>` package holds one executable.
- Releases are built and tested on each platform in GitHub Actions from a protected tag, and published to npm through **trusted publishing** (no npm token exists), with **provenance**.
- GitHub releases are **immutable**. The executables carry build attestations, and a `SHA256SUMS` file lists them.
- Every workflow pins its actions to full commit SHAs, reads contents only unless a job needs more, and is checked by actionlint and zizmor.
- The executables are not code-signed in 0.x.
