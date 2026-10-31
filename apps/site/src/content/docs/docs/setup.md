---
title: The setup
description: The five steps Lookover's setup takes you through, what each asks and why, organisations included.
---

`lookover start` opens the setup in your browser the first time. It has five steps. No step moves on by itself: a step that is done says so, and **Continue** takes you to the next. A step you passed opens again from the list of steps.

## 1. AI

Sign in to Claude, Codex or both. A terminal opens to sign in, through the program's own flow: Lookover never reads your tokens.

One is enough. With both, one AI looks for problems and the other checks each one before it is posted. Codex must be signed in with ChatGPT: an API key is not a plan.

## 2. GitHub

Lookover reads pull requests and posts its reviews through **Lookover Dev**, one GitHub App for everyone who runs Lookover. You sign in to it, and Lookover posts as you. Your teammates see your review written by you, opening with “Lookover”, a summary with Lookover's badge, and a Lookover check.

**Sign in with GitHub.** Lookover shows a code. **Copy code and open GitHub** copies it and opens `github.com/login/device`; enter it there. GitHub then asks you to authorise Lookover Dev, by `lookover-dev`, to act on your behalf. Authorise it, and the setup tab says who is signed in. The code works for 15 minutes; past that, **Sign in with GitHub** gives a new one.

No App to create, no key to keep: Lookover Dev has no private key ([where your code goes](/docs/security/)).

**Your accounts.** Under the sign-in, one row for each account, with its state or its one fix:

- **Installed:** Lookover Dev is on the account, with the repositories it may see. On GitHub, you pick which. With none yet, **Choose repositories** opens where you pick them.
- **Install on &lt;account&gt;:** your own account, or an organisation you own, where it isn't installed yet. GitHub's page installs it and asks which repositories it may see.
- **Ask to install on &lt;organisation&gt;:** an organisation where you are a member, not an owner. On GitHub's page, Install becomes Request, and GitHub emails the organisation's owners.
- **Waiting for an owner of &lt;organisation&gt;:** once you asked. GitHub tells only the App whether a request was sent, so Lookover remembers that you asked, and when. If you sent the request, GitHub emailed its owners. **Ask an owner of &lt;organisation&gt;** opens the organisation's owners on GitHub, to ask one, and **Ask again** opens GitHub's page again. Once an owner installs it, the row turns into an installed account by itself.
- **Install on another account:** always last. GitHub's own page lists every account you belong to.

Lookover names your organisations from your `gh`, when it is signed in as you. Without it, Install on another account still reaches them.

Lookover Dev asks for exactly these permissions, and nothing else: Metadata, read; Contents, read; Pull requests, write; Checks, write; Issues, write. It has no webhook: Lookover asks GitHub what changed, from your computer.

**Continue** needs one account with a repository.

Settings › GitHub later shows who is signed in, with the same accounts. **Sign in again** signs in as someone else: its code shows in place, and **Cancel** keeps you signed in.

**When an account can't be used,** its row says why, with one fix. Settings › GitHub, Repositories and the status menu say the same:

| Cause | The fix |
|---|---|
| Signed out: the sign-in went unused for about 6 months, or was revoked | **Sign in again**, its code shown in place |
| Not installed | **Install on &lt;account&gt;**, or **Ask to install on &lt;organisation&gt;** as a member |
| No longer installed | On an account you own, **Install on &lt;account&gt;**. Elsewhere, **Ask an owner of &lt;organisation&gt;** |
| Waiting for an owner | **Ask an owner of &lt;organisation&gt;**, the organisation's owners on GitHub |
| Suspended | On an account you own, **Unsuspend it on GitHub**. Elsewhere, **Ask an owner of &lt;organisation&gt;**: Lookover names who suspended it when GitHub says |
| SSO not authorised | **Sign in with SSO**, on the organisation's single sign-on page |

### Use your own App

The second way in: a GitHub App of your own, which posts the reviews as itself, under its own name. Use it when:

- your organisation won't install a third-party App, or restricts them;
- you want a bot of your own;
- your data folder was set up with your own App before: it keeps working that way.

The setup offers it beside Sign in with GitHub, and Settings › GitHub later, where it replaces the sign-in. The App asks for the same permissions, and its private key stays on your computer.

**Create your App.** Choose where the App lives:

- **Your GitHub account,** for the repositories you own.
- **An organisation you're an admin of.** Lookover asks your own `gh` which organisations those are. With `gh` missing or signed out, the step says so and gives the one command to fix it.

GitHub then shows the App ready to create. Confirm with your password and rename it if you like, then choose which repositories it can see. GitHub shows Lookover's own page, which says the App is installed, with **Back to setup**; the setup tab follows by itself.

**Use an existing App.** For an App you already have: the one you use on another computer (generate a new key for it on GitHub), or one an admin of your organisation created for you. Give its id (on the App's page on GitHub, under "About") and its private key (the `.pem` file GitHub gave you). The key is read once and never shown. An App on an organisation needs `gh` signed in as a member; an App missing a permission is refused, naming each one it lacks.

Not an admin of your organisation? Ask an admin to create the App there, then use it as above.

## 3. Repositories

Pick the ones to review, among those Lookover can see.

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
