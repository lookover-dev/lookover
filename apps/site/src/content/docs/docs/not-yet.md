---
title: What it doesn't do yet
description: Lookover is in 0.x. What it doesn't do, and where it has had little use.
---

Lookover is in 0.x: it works, and it changes. This is what it doesn't do yet.

- **GitHub only** (github.com). No GitLab, Bitbucket or GitHub Enterprise Server.
- **Subscriptions only,** through the `claude` and `codex` CLIs. No API keys, no other AI.
- **Your own pull requests.** Another author's pull request is reviewed when you ask, by Claude alone. A fork's is never reviewed by itself: ask with `/lookover review`, and Claude reviews it.
- **On your computer only.** No server mode yet. A team doesn't share one Lookover: each colleague runs their own ([your plan's terms](/docs/terms/)).
- **Windows is where Lookover is used day to day.** macOS and Linux pass each release's tests and a start on a real runner, and have had little use beyond that.
- **No Alpine and other musl Linux:** Lookover's Linux executables need glibc.
- **No signed executables in 0.x.** npm's provenance says where each one was built.
- A console window flashes for a moment at login on Windows, while Lookover starts.
- A post that fails can't be retried from the app yet.
- A hand edit to a settings file counts from the next start.

Something missing that you need? Say so in an [issue](https://github.com/lookover-dev/lookover/issues).
