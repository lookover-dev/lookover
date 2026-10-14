---
title: The setup
description: The five steps Lookover's setup takes you through, what each asks and why, organisations included.
---

`lookover start` opens the setup in your browser the first time. It has five steps. No step moves on by itself: a step that is done says so, and **Continue** takes you to the next. A step you passed opens again from the list of steps.

## 1. AI

Sign in to Claude, Codex or both. A terminal opens to sign in, through the program's own flow: Lookover never reads your tokens.

One is enough. With both, one AI looks for problems and the other checks each one before it is posted. Codex must be signed in with ChatGPT: an API key is not a plan.

## 2. GitHub

Lookover reads pull requests and posts its reviews as your own GitHub App, under the App's name, so its reviews are clearly its own and your coding agent can wait for them.

**Create your App.** Choose where the App lives:

- **Your GitHub account,** for the repositories you own.
- **An organisation you're an admin of.** Lookover asks your own `gh` which organisations those are. With `gh` missing or signed out, the step says so and gives the one command to fix it.

GitHub then shows the App ready to create. Confirm with your password and rename it if you like, then choose which repositories it can see. GitHub shows Lookover's own page, which says the App is installed, with **Back to setup**; the setup tab follows by itself.

The App asks for exactly these permissions, and nothing else: Metadata, read; Contents, read; Pull requests, write; Checks, write; Issues, write. It has no webhook: Lookover asks GitHub what changed, from your computer. Its private key stays on your computer ([where your code goes](/docs/security/)).

**Use an existing App.** For an App you already have: the one you use on another computer (generate a new key for it on GitHub), or one an admin of your organisation created for you. Give its id (on the App's page on GitHub, under "About") and its private key (the `.pem` file GitHub gave you). The key is read once and never shown. An App on an organisation needs `gh` signed in as a member; an App missing a permission is refused, naming each one it lacks.

Not an admin of your organisation? Ask an admin to create the App there, then use it as above.

## 3. Repositories

Pick the ones to review, among those the App can see.

## 4. First review

Pick an open pull request:

- **Review this pull request** reviews it and posts on GitHub.
- **Preview here only, post nothing** reviews it and shows the result in the app alone.

A pull request you open now shows in about a minute. With none, **Continue**.

## 5. Your coding agent

All of it is optional. The step installs the `lookover-review-loop` skill for Claude Code and Codex, so your agent waits for the review, fixes what it found, pushes and asks again until nothing is left. [Your coding agent](/docs/coding-agent/) says how.

Under it, a card says reviews keep running in the background: Lookover starts each time you log in. **Don't start at login** is one click away, and Settings changes it later. **Go to my reviews** ends the setup.

## Then

From then on, Lookover reviews each pull request you open, once it is ready for review. Settings › When to review adds **Again after every push**. You can also ask on any pull request with a comment, `/lookover review`, or with **Review now** in the app.
