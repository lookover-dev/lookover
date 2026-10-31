---
title: Getting started
description: What you need, how to install Lookover, and the setup up to your first review.
---

Lookover reviews your GitHub pull requests with Claude and ChatGPT, on the subscriptions you already pay for. It runs on your own computer and posts its review on the pull request. This page takes you from nothing to your first review.

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

Lookover starts in the background and opens in your browser:

```text wrap
Lookover runs in the background.
Lookover is opening in your browser.
Don't see it? `lookover open --no-open` prints a link to paste (it works once, within 2 minutes).
You can close this terminal.
```

Close the terminal whenever you like: it keeps running, and starts again each time you log in (Settings turns that off).

The setup takes a few minutes, one step at a time:

1. **AI.** Sign in to Claude, Codex or both.
2. **GitHub.** Sign in with GitHub: enter the code it shows on GitHub's page, then install Lookover Dev on your account or your organisation and pick the repositories it may see. Lookover posts its reviews as you, each opening with “Lookover”. [The setup](/docs/setup/#2-github) also says how to use an App of your own.
3. **Repositories.** Pick the ones to review.
4. **First review.** Pick an open pull request, or preview a review that posts nothing.
5. **Your coding agent.** Install the `lookover-review-loop` skill for Claude Code and Codex, so your agent waits for the review, fixes what it found, pushes, and asks again until nothing is left.

From then on, Lookover reviews each pull request you open, once it is ready for review.
