# Lookover

A second look before merge. Lookover reviews your GitHub pull requests with Claude and ChatGPT, on the subscriptions you already pay for. It runs on your own computer, posts its review on the pull request, and is built for coding agents: the agent waits for the review, fixes what it found, pushes, and asks again until nothing is left.

Lookover is in 0.x: it works, and it changes. What it doesn't do yet is below.

## What it does

- **Reviews each pull request you open,** when it is ready for review. Optionally after every push, when you comment `/lookover review`, or when you click "Review now" in the app.
- **Finds, then confirms.** One AI looks for problems, the other checks each one before it is posted. Use Claude, ChatGPT or both.
- **Posts one review on GitHub:** inline comments placed on the diff, one summary comment that stays up to date, and a check on each commit with its findings in a form a program can read.
- **Reads the threads on the next round.** A finding you fixed has its thread resolved; a finding is never posted twice; a reply you wrote is answered.
- **Follows your rules:** `REVIEW.md`, `AGENTS.md` and `CLAUDE.md`, read from the default branch.
- **Shows what is happening** in an app in your browser: the queue, each review and its rounds, each AI and its sign-in, the logs, and the settings.

## What you need

- A Claude subscription (Pro or Max) with the [`claude`](https://docs.anthropic.com/en/docs/claude-code) CLI, a ChatGPT subscription (Plus or Pro) with the [`codex`](https://github.com/openai/codex) CLI, or both. Install them; Lookover's setup signs you in to each.
- `git` and the [`gh`](https://cli.github.com) CLI on your PATH.
- Node.js 18 or later and npm, to install Lookover.
- A GitHub account. Lookover reviews the repositories of your personal account, or of an organisation you belong to.
- Windows, macOS or Linux, on x64 or arm64 (Windows: x64).

## Install

```sh
npm install -g lookover
```

npm installs the one executable your platform needs and puts `lookover` on your PATH. Nothing runs at install: there is no install script, so `--ignore-scripts` changes nothing.

## First run

```sh
lookover start
```

Lookover starts in the background and opens in your browser. Close the terminal whenever you like: it keeps running, and starts again each time you log in (Settings turns that off).

The setup takes a few minutes, one step at a time:

1. **AI.** Sign in to Claude, Codex or both.
2. **GitHub.** "Create your App" makes a GitHub App on your account or your organisation; then pick the repositories it may see. The App is how Lookover reads pull requests and posts its reviews, under its own name.
3. **Repositories.** Pick the ones to review.
4. **First review.** Pick an open pull request, or preview a review that posts nothing.
5. **Your coding agent.** Install the skill, below.

The other commands:

| Command | What it does |
|---|---|
| `lookover open` | Opens the app with a new one-time link. `--no-open` prints the link instead |
| `lookover status` | Running or stopped, its address, data folder and version. Exit 0 running, 3 stopped |
| `lookover stop` | Stops it |
| `lookover help` | Every command and its options |

To update, stop it first: on Windows the running program holds its file open.

```sh
lookover stop
npm update -g lookover
lookover start
```

## The agent loop

A coding agent that pushes to a pull request can run the review loop itself:

```sh
lookover wait       # asks for a review of the pushed commit, waits for it
lookover feedback   # the findings waiting on you, each with its thread
lookover reply F3 wont-fix "The value is checked by the caller."
```

`lookover wait` exits 0 when there is nothing to fix and 3 when there is; 4 means a person is needed. `lookover reply` answers a finding: `fixed`, `wont-fix`, `disputed`, `deferred` or `question`. The next round reads the answer.

Setup's last step, or Settings › Your coding agent, installs the `lookover-review-loop` skill for Claude Code and Codex. It teaches the agent the loop, and calls Lookover by its full path, so the agent needs nothing on its PATH. Then tell your agent: "Get pull request #12 through Lookover's review: fix what it found and push."

## What it doesn't do yet

- **GitHub only** (github.com), one App per Lookover. No GitLab, Bitbucket or GitHub Enterprise Server.
- **Subscriptions only,** through the `claude` and `codex` CLIs. No API keys, no other AI.
- **Your own pull requests.** Another author's pull request is reviewed when you ask, by Claude alone. A fork's is never reviewed by itself: ask with `/lookover review`, and Claude reviews it.
- **On your computer only.** No server mode yet.
- **Windows is where Lookover is used day to day.** macOS and Linux pass each release's tests and a start on a real runner, and have had little use beyond that.
- **No Alpine and other musl Linux:** Lookover's Linux executables need glibc.
- **No signed executables in 0.x.** npm's provenance says where each one was built.
- A console window flashes for a moment at login on Windows, while Lookover starts.
- A post that fails can't be retried from the app yet.
- A hand edit to a settings file counts from the next start.

## Security

- **What runs where.** Lookover runs on your computer, as you. It reviews with the official `claude` and `codex` CLIs, signed in through their own flows: Lookover never reads your subscription's tokens. It talks to GitHub, and to nothing else: no telemetry, no server of ours. On GitHub it acts as your App, except in two places that use your own `gh` login: the setup reads who you are and the organisations you administer, and `lookover wait` and `lookover reply` write as you.
- **What the AI may do.** Each review runs in a read-only sandbox, on a checkout of the pull request. On Windows, Codex's sandbox isn't elevated: accepted because Codex reviews only your own changes. Hooks, MCP servers and settings that a pull request brings are turned off. No GitHub token reaches the model.
- **What it posts.** The review, its inline comments, the summary comment and the check, on the pull request it reviewed, as your App. As you, when your coding agent runs them: `lookover wait`'s `/lookover review` comment and the threads it resolves once fixed, and `lookover reply`'s answers on a thread. Secrets in a known shape are taken out of what it posts and of its logs.
- **What it keeps.** Everything is in one data folder on your computer: the reviews, the settings, the logs. The App's private key is encrypted there, and the key that opens it is in your system's credential store. With no credential store (on some Linux systems), the private key is kept unencrypted in a file only you can open.
- **Forks are never reviewed by themselves,** so a stranger's code doesn't reach an AI unless you ask.

Found a vulnerability? Please report it privately, as [SECURITY.md](https://github.com/lookover-dev/lookover/blob/main/SECURITY.md) says, never in a public issue.

## Remove it

1. In Settings › Your coding agent, "Remove the skill".
2. In Settings, turn off "Start at login".
3. `lookover stop`, then `npm uninstall -g lookover`.
4. Delete Lookover's entry in your system's credential store: its name is `key.entry` in `github/app.json`, in the data folder (`lookover status` names the folder). With `"kept": "file"` there, there is no entry: the key is a file in that folder.
5. Delete the data folder, and the App on GitHub if you no longer want it.

## Contributing

Bugs and ideas are welcome in [issues](https://github.com/lookover-dev/lookover/issues). To build Lookover or send a change, read [CONTRIBUTING.md](https://github.com/lookover-dev/lookover/blob/main/CONTRIBUTING.md).

## Licence

[MIT](https://github.com/lookover-dev/lookover/blob/main/LICENSE), © 2026 Samuel Asensi.
