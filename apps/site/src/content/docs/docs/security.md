---
title: Where your code goes
description: What leaves your computer, what the AI may do, what Lookover posts and keeps, and how to report a flaw.
---

Lookover runs on your computer, as you. There is no account with us, no server of ours and no telemetry. The source is open: [github.com/lookover-dev/lookover](https://github.com/lookover-dev/lookover).

## What leaves your computer

Your code goes only where it already goes:

- **To GitHub.** Lookover fetches the pull request and posts its review there. It talks to GitHub and to nothing else.
- **To Claude or ChatGPT, through their own programs.** Lookover reviews with the official `claude` and `codex` CLIs, signed in through their own flows. What the AI reads of the pull request reaches Anthropic or OpenAI as any session in your terminal would. Their programs' own traffic is theirs.

Lookover never reads your subscription's tokens, and gives the CLIs no API key and no GitHub token.

On GitHub, Lookover acts as you, through Lookover Dev: the App you sign in to with GitHub. Its token reaches only what both you and the App may reach, on the accounts where it is installed. Lookover also reads your organisations, and whether you own each, from your own `gh`, when it is signed in as you; it decides nothing from them.

**Lookover Dev has no private key.** None was ever generated, and nobody holds one, Lookover's makers included: there is no server to keep it. Your sign-in is yours alone: its token lasts 8 hours, Lookover renews it on your computer, and the renewal lasts about 6 months unused.

### What installing Lookover Dev means

Lookover Dev is the only way in: an organisation that installs it trusts the `lookover-dev` account on GitHub, which owns it. That account could:

- **make a private key,** and with it act as the App itself, under its name, on the repositories each account gave it: anything the App's permissions allow there. Read their code; post, edit or delete comments, anyone's; edit, close or reopen issues and pull requests; post checks;
- **turn on a webhook** for the App, and receive those repositories' events that its permissions cover, without asking anyone: GitHub asks an account's owners only about new permissions;
- **ask for more permissions.** GitHub applies them on an account only once one of its owners accepts.

It can't act as you: your sign-in never leaves your computer. And it reaches only the repositories each account gave it, with the permissions [the setup](/docs/setup/#2-github) lists. The program that holds your sign-in comes from the same makers: [how Lookover ships](#how-lookover-ships) says how it is built and published. An organisation that won't trust it can't use Lookover.

## What the AI may do

- Each review runs on a checkout of the pull request, in a read-only sandbox.
- Hooks, MCP servers and settings that a pull request brings are turned off.
- No GitHub token reaches the model.
- On Windows, Codex's sandbox isn't elevated: accepted because Codex reviews only your own changes.
- **Forks are never reviewed by themselves,** so a stranger's code doesn't reach an AI unless you ask. Another author's pull request is reviewed when you ask, by Claude alone.

## What it posts

On the pull request it reviewed: a review a round holding its findings on their lines, its status at the end of the pull request's description, kept up to date, and a check on the commit. Always as a comment: it never approves, requests changes or merges.

Your teammates see your review written by you, its status in the description and a Lookover check. Each line comment, each reply and the status open with Lookover's wordmark, so its words read as Lookover's, not yours.

In the description, Lookover rewrites only its own part, between two hidden markers, after your text. It reads the description just before each write, but GitHub can't refuse a write over a newer edit: an edit saved in that same moment can be lost. A description rewritten whole loses the status until Lookover writes it again.

As you too, when your coding agent runs them: `lookover wait`'s `/lookover review` comment and the threads it resolves once settled (fixed, withdrawn or dismissed), and `lookover reply`'s answers on a thread.

Secrets in a known shape are taken out of what it posts and of its logs.

## What it keeps

Everything is in one data folder on your computer ([the commands](/docs/commands/#the-data-folder) say where): the reviews, the settings, the logs, what each review sent the AI and got back, and a copy of each repository it reviews.

- **The logs:** `logs/lookover-<date>.log`, one file a day, kept 30 days. The app shows the same file.
- **Each review's raw material:** `runs/`, the prompts it sent the AI and the AI's raw output, your private code included. Kept 30 days, then deleted.
- **Your sign-in with GitHub,** its token and the token that renews it, is encrypted there, and the key that opens it is in your system's credential store (Windows Credential Manager, macOS Keychain, or the Secret Service on Linux). With no credential store, as on some Linux systems, it is kept unencrypted in a file only you can open.
- **The organisations you asked to install on,** and when, until Lookover Dev reaches them or you sign in as someone else.

## How Lookover ships

- The npm packages have **no runtime dependencies and no install scripts**: `lookover` is a small Node launcher, and each `@lookover/<platform>` package holds one executable.
- Releases are built and tested on each platform in GitHub Actions from a protected tag, and published to npm through **trusted publishing** (no npm token exists), with **provenance**.
- GitHub releases are **immutable**. The executables carry build attestations, and a `SHA256SUMS` file lists them.
- The executables are not code-signed in 0.x.

## Report a vulnerability

Privately, through GitHub: [Report a vulnerability](https://github.com/lookover-dev/lookover/security/advisories/new), on the repository's Security tab. Never in a public issue. You get an answer within 7 days. The [security policy](https://github.com/lookover-dev/lookover/blob/main/SECURITY.md) says what to include and what is in scope.

Security fixes go to the latest 0.x minor, as a patch release: update to it.
