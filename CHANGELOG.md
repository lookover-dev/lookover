# Changelog

What changed in each version of Lookover, for the people who use it. Each version's notes are written when it is released.

## [0.15.0](https://github.com/lookover-dev/lookover/compare/v0.14.0...v0.15.0) (2026-11-11)

### Features

- **setup:** the choice of repositories belongs to the person signed in. When someone else signs in, at start or while Lookover runs, setup asks them to choose again, and every review not finished yet is cancelled, with nothing written to GitHub.
- **setup:** a review your coding agent asks for with `lookover wait` before you have chosen your repositories waits for your choice, even across a restart, and runs once you choose, if its repository is still on.
- **cli:** when `lookover wait` sees no review in time (exit 9), its message names both reasons: Lookover not running, or the repositories not chosen yet in setup.
- **github:** when a push ends a review asked on a fork's pull request before it started, the status block says "Didn't look over" that commit and how to ask again, instead of still waiting. A review still running or due keeps its block.

### Bug Fixes

- **setup:** an account whose repositories Lookover is still reading says so, at every step of setup and after it, instead of "No repository yet."
- **setup:** coming back to the app after a look for a new install has ended no longer starts another one.
- **settings:** Settings opened at Your coding agent stays there while the page fills in, until you scroll.
- **github:** signing in to GitHub no longer hangs on a slow answer: each call has a time limit, and is sent again only when nothing reached GitHub.
- **reviews:** "Review a pull request…" in the palette lists only the pull requests whose page offers Review now or Review again.

## [0.14.0](https://github.com/lookover-dev/lookover/compare/v0.13.0...v0.14.0) (2026-11-10)

### Features

- **setup:** an account you install the GitHub App on, or whose repositories you change on GitHub, shows within seconds: every link to GitHub's install page or an installation's settings starts a look, every few seconds for up to three minutes, and coming back to the app checks at once. Until then setup, Settings › GitHub and the foot of Repositories say Lookover is looking, with Check again at any time; a toast says when the account arrives.
- **app:** a fix in the status band or the status menu that sends you to GitHub says Looking… while its look runs.
- **github:** without a look, Lookover reads your installations every 2 minutes instead of 5, and when GitHub asks it to wait, it waits once for the whole sign-in and lists again as soon as the wait ends.

### Bug Fixes

- **setup:** on a phone, an account's Installed status is as tall as its line, so a hovered row no longer runs past it.

## [0.13.0](https://github.com/lookover-dev/lookover/compare/v0.12.0...v0.13.0) (2026-11-10)

### Features

- **app:** motion where it helps you follow a change: menus, the palette, toasts and notices appear and leave, a group folds and opens by its rows, a review moves to its new section on Home, and a review's steps advance as its verdict comes in. It is short, never delays what you do, and stops entirely when your system asks for reduced motion.
- **setup:** your accounts show as soon as you are signed in, before their repositories are read, and an account Lookover is still looking at says Looking… instead of being called not installed.

### Bug Fixes

- **app:** updating from an older version on the same data folder no longer leaves a blank page or a status menu that won't open: what the new version can't read is dropped, and its log says so.
- **app:** an error in one screen or panel stays there, and the rest of the app keeps working.
- **app:** the fonts load under the app's content security policy, with no error in the browser's console.
- **app:** no empty room is held for text you can't see: Repositories' heads, the accounts list, Try it, Your coding agent and setup take only the lines they show, at any window width.
- **repositories:** a folded group under a filter says what it counts, as in "16 repositories shown".
- **reviews:** on a phone, First review's Open on GitHub is an icon button, and a long title wraps in its column.

## [0.12.0](https://github.com/lookover-dev/lookover/compare/v0.11.0...v0.12.0) (2026-11-09)

### Bug Fixes

- **reviews:** a repository you turned off has none of its pull requests in Reviews, under Mine or Everyone, in the counts or in the palette; a review already running or waiting there stays listed until it ends.
- **cli:** `lookover open`, `stop` and `status` find the running service whatever the spelling of `--home`: a short Windows name, another case or a trailing separator. Start at login reads the data folder the same way.

## [0.11.0](https://github.com/lookover-dev/lookover/compare/v0.10.0...v0.11.0) (2026-11-08)

### Features

- **setup:** nothing is reviewed or posted on GitHub until you have chosen your repositories in setup; a pull request opened before then gets no check and no comment.
- **repositories:** Repositories is grouped by account, each with its count and one switch for all of it; heads stay in view as you scroll and fold away. Past ten repositories, search and a filter (All, Reviewing, Off) appear, and setup's Repositories step folds the same way.
- **repositories:** a repository that left is said by how it left: an account Lookover can no longer reach is one No access notice with its fix, the rest one quiet count you can dismiss at once.
- **reviews:** a failed review says why and what limit it hit, on the check, in the app with a Failed notice and its log, and in `lookover wait`; Try again is offered only where another try can help.
- **reviews:** a finding still there after a push that didn't answer it says why on its thread.
- **reviews:** the request comment says when your coding agent asked, and a review's log says who asked.
- **app:** a clearer look throughout, in both themes: stronger contrast for muted text, commits and paths drawn as code everywhere, one layout for the coding agent's rows and for notices, status chips alike on every screen, a calmer status menu and palette, and logs that name a pull request once.

### Bug Fixes

- **review:** a brief network failure talking to GitHub is tried again, each try with a time limit, instead of failing the review.
- **review:** a repository with paths longer than Windows allows checks out and is reviewed on Windows.
- **review:** git's errors are read in any system language, so a path too long or a fetch limit is said as what it is.

## [0.10.0](https://github.com/lookover-dev/lookover/compare/v0.9.0...v0.10.0) (2026-11-06)

### Features

- **reviews:** a pull request opened by someone else gets nothing from Lookover on GitHub, no check and no comment, until you ask with `/lookover review` or **Review now**. Your own fork's pull requests are still skipped and say so.
- **reviews:** Home and All reviews start at your own pull requests, under **Mine**, with **Everyone** beside it and a count on each; a teammate's pull request offers **Review now**.
- **reviews:** each row names who opened the pull request, then who wrote it, as in "sasensi · written by Claude".
- **agent:** the review loop's skill says a colleague's pull request has no check of yours until you ask.

### Bug Fixes

- **review:** a large repository can be reviewed: the first fetch takes one commit deep instead of the whole history, and git is stopped only when it goes silent, not when it is slow.
- **review:** a fetch that fails or is stopped no longer leaves its partial download behind, and the next one clears what an earlier one left.

## [0.9.0](https://github.com/lookover-dev/lookover/compare/v0.8.0...v0.9.0) (2026-11-04)

### Bug Fixes

- **cli:** `lookover wait`, `feedback` and `reply` read only the round of their own pull request: another pull request on the same commit no longer answers for it.
- **reviews:** with nothing reviewed yet, two repositories of the same name under two accounts are each named with their owner, not as one name twice.
- **reviews:** with nothing reviewed yet, Lookover says to turn a repository on when none is, and waits for the App when it can see none.

## [0.8.0](https://github.com/lookover-dev/lookover/compare/v0.7.0...v0.8.0) (2026-11-03)

### Features

- **setup:** an AI whose safety check couldn't finish says so in plain words, with **Try again** in setup, the status menu and the alert band; it offers a sign-in only when that AI is signed out.
- **setup:** an AI at its limit offers **Check again**, and says when the limit resets.

### Bug Fixes

- **engines:** a safety check that couldn't finish is run again at once, and no longer reads as a failed one; a known failure still wins.
- **engines:** a safety check the AI's server turned away before starting ("model at capacity") counts as unfinished, not failed.
- **engines:** Codex's safety check is asked to write its test file with one plain command, so Windows' PowerShell stops it before the check far less often.

## [0.7.0](https://github.com/lookover-dev/lookover/compare/v0.6.0...v0.7.0) (2026-11-03)

### Breaking changes

- **setup:** "Use your own App" is gone: you sign in with GitHub, and Lookover reviews as you through its shared App. A data folder set up on its own App starts at setup again; sign in there, and delete the old App on GitHub when you like.
- **github:** the summary comment is gone. Lookover writes its status in a block of its own at the end of the pull request's description, and rewrites only that block.
- **cli:** `lookover wait`, `feedback` and `reply` no longer take `--app`.

### Features

- **github:** the status block says where the pull request stands: looking over a commit, what's left to fix with a link to each thread, what needs your look, waiting for an engine's limit, or why Lookover couldn't look.
- **github:** every post opens with Lookover's wordmark, in GitHub's light and dark themes.
- **github:** a review carries only its line comments; a round with nothing to say on a line posts no review.
- **github:** a finding outside the diff links to its lines, which GitHub shows as a snippet.
- **github:** when the finder wrote a fix, its line comment carries it as a suggestion you can commit from GitHub.
- **github:** Lookover's replies on a thread say what they are: withdrawn, kept, or yours to decide.
- **cli:** `lookover wait` also resolves the threads Lookover withdrew or dismissed, and says why.
- **setup:** the sign-in code is set in Atkinson Hyperlegible Mono, so `0` and `D`, `O`, `1` and `I` read apart.

### Bug Fixes

- **setup:** when GitHub asks Lookover to slow down while you sign in, it waits as long as GitHub says.

## [0.6.0](https://github.com/lookover-dev/lookover/compare/v0.5.0...v0.6.0) (2026-11-02)

### Features

- **setup:** once Lookover has reviewed one of your pull requests by itself, First review says so and offers **Continue**; reviewing another pull request stays possible, not required.
- **setup:** "Try it" points your coding agent at a review Lookover posted, whichever step posted it, and says when `lookover wait` will report a pass.

### Bug Fixes

- **app:** a preview with findings open shows as **Preview** under Needs you ("1 preview to read."), never under "Nothing needs you." above a finding to fix.

## [0.5.0](https://github.com/lookover-dev/lookover/compare/v0.4.0...v0.5.0) (2026-11-01)

### Features

- **app:** when Claude or Codex isn't installed, Lookover gives the command that installs it on this computer.
- **app:** a finding's `inline code` shows as code, as it does on GitHub.

### Bug Fixes

- **setup:** First review shows a pull request Lookover already reviewed as reviewed, with its link on GitHub, instead of offering to review it again.
- **review:** Lookover never reviews the same commit twice when a review of it is already on GitHub.
- **app:** the status pill, its menu and the band agree: pink when something needs you, amber when Lookover is only waiting.
- **app:** GitHub out of reach is a wait, not a button: Lookover tries again every minute by itself.
- **app:** a refused or lost key of your own App is fixed in one place, Settings › GitHub, which says what happened next to **Add a new key**.
- **app:** All reviews dims the filters that hold nothing, instead of moving the bar.
- **app:** elapsed times read as durations ("12 min 40 s"), never as a time of day, and hold their width while they tick.
- **app:** separator lines show on menus and dialogs in the dark theme.
- **app:** an unexpected error in the service's log always says its message.

## [0.4.0](https://github.com/lookover-dev/lookover/compare/v0.3.0...v0.4.0) (2026-10-31)

### Features

- **app:** when another copy of Lookover starts at login on this computer, setup, Settings, the status menu and `lookover status` say which one, by its command, and Settings offers **Start this one instead**.

### Bug Fixes

- **app:** a second copy of Lookover no longer takes over your start at login, and turning it off removes only its own.
- **setup:** First review and Repositories show a pull request opened during setup within seconds, with no reload.
- **app:** a pull request's age is when it was opened on GitHub, not when Lookover first saw it.
- **review:** "Getting the changes" fetches only the pull request's commits and the default branch: on a repository with thousands of pull requests, seconds instead of half a minute.

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
