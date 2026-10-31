# Changelog

What changed in each version of Lookover, for the people who use it. Each version's notes are written when it is released.

## [0.3.0](https://github.com/lookover-dev/lookover/compare/v0.2.3...v0.3.0) (2026-10-31)

Already set up with your own App? Nothing changes until you choose to sign in: your App keeps working as before.

### Features

- **setup:** **Sign in with GitHub.** Lookover runs on Lookover Dev, one GitHub App for everyone: enter the code Lookover shows on GitHub's page, and there is no App to make and no key to keep. Lookover Dev has no private key.
- **setup:** one list of your accounts, yours and your organisations': where Lookover Dev is installed, **Install on** the others, **Ask to install on** an organisation you don't own, and **Waiting for an owner** until one does.
- **review:** signed in, Lookover reviews your pull requests on every account where Lookover Dev is installed, at once. Your teammates see your review written by you, a summary with Lookover's badge, and a Lookover check.
- **review:** the review and each comment on a line open with "Lookover".
- **app:** each problem with an account has one fix, the same in the setup, Settings › GitHub, Repositories and the status menu: sign in again, install, ask an owner, or open the organisation's single sign-on page.
- **app:** Repositories are grouped by account, and a pull request is named `owner/repository#number` everywhere.
- **agent:** `lookover wait`, `feedback` and `reply` find Lookover Dev's check by default, and read only your own; `--app` or `LOOKOVER_APP` name your own App.

## [0.2.3](https://github.com/lookover-dev/lookover/compare/v0.2.1...v0.2.3) (2026-10-26)

### Bug Fixes

- **site:** the landing page's headline no longer jumps on a first visit: its fonts load sooner, and the text holds its place until they arrive.
- **cli:** after a crash, `lookover start` no longer reads the old service's address and fails with "Lookover didn't give a link".

## 0.2.2 (never published)

Not released: its changes ship in the next version.

## [0.2.1](https://github.com/lookover-dev/lookover/compare/v0.2.0...v0.2.1) (2026-10-15)

### Bug Fixes

- **site:** clearer navigation and search in the docs, more readable commands on phones and tablets, and consistent hover and keyboard focus in both themes.
- **site:** the landing page shows a condensed review preview, with matching branding and controls across the site and docs.

## [0.2.0](https://github.com/lookover-dev/lookover/compare/v0.1.0...v0.2.0) (2026-10-14)

### Features

- **site:** [lookover.dev](https://lookover.dev) is online: what Lookover does, and its docs, from the setup and your coding agent to the commands, where your code goes and what it doesn't do yet.
- **app:** the eyes you see while Lookover works, and its avatar beside each review, are the logo's own drawing.
- **install:** npm's page for `lookover` links to lookover.dev.

## 0.1.0 (2026-10-13)

The first public release.

### Features

- **review:** reviews each pull request you open on GitHub with Claude, ChatGPT or both, on the subscriptions you already pay for: one AI finds, the other confirms each finding before it is posted.
- **review:** posts one review: inline comments on the diff, a summary comment kept up to date, and a check on each commit.
- **review:** reads its threads on the next round: a fixed finding has its thread resolved, a finding is never posted twice, a reply is answered.
- **review:** follows your `REVIEW.md`, `AGENTS.md` and `CLAUDE.md`, read from the default branch; nothing in a pull request can steer the reviewer.
- **setup:** signs you in to each AI, makes your GitHub App on your account or an organisation you administer, and picks the repositories to review.
- **app:** the queue, each review and its rounds, what each AI is doing now, the logs and the settings, in your browser.
- **cli:** `lookover start`, `open`, `status` and `stop`; Lookover runs in the background and starts again at login.
- **agent:** `lookover wait`, `feedback` and `reply`, and a skill for Claude Code and Codex, so your coding agent fixes what Lookover found and asks again.
- **install:** `npm install -g lookover` on Windows (x64), macOS and Linux (x64 and arm64).
