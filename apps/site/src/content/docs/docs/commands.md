---
title: The commands
description: Every lookover command, its main options and its exit codes. lookover help lists the rest.
---

One command, `lookover`, with a verb after it. This page gives each verb's main options; `lookover help` lists them all.

## The service

| Command | What it does |
|---|---|
| `lookover start` | Starts Lookover in the background, or finds the one running, then opens it in your browser. The terminal can then be closed. `--no-open` prints the link instead |
| `lookover open` | Opens the running Lookover in your browser, with a new link that works once, within 2 minutes. `--no-open` prints the link instead |
| `lookover status` | Running or stopped, its address, data folder, version and process, and whether it starts at login. `--json` for a program |
| `lookover stop` | Stops it, as Ctrl+C would. One that doesn't answer within 30 seconds is ended |
| `lookover serve` | Runs Lookover in this terminal until Ctrl+C, instead of in the background |
| `lookover --version` | The version installed |
| `lookover help` | Every command and its options |

`lookover start` says what it did:

```text wrap
Lookover runs in the background.
Lookover is opening in your browser.
Don't see it? `lookover open --no-open` prints a link to paste (it works once, within 2 minutes).
You can close this terminal.
```

On a Lookover already running, the first line is "Lookover already runs." When Windows ties it to the terminal it started from, the last line says to keep that terminal open instead.

The app opens only through such a link. The bare address `lookover status` shows has no session: it says "This tab isn't signed in." and names the command to run. So does a tab whose session ended. Run `lookover open` for a fresh link.

### Exit codes

Each exits 0 when done (for `status`: running), 1 on an error, 2 when it can't read its arguments, and 3 when Lookover isn't running (`status` and `open`). `stop` exits 0 then: nothing is left running.

## For your coding agent

| Command | What it does |
|---|---|
| `lookover wait` | Asks for the review of the commit you pushed, if nobody has, waits for its check and says what to do next by its exit code |
| `lookover feedback` | The findings waiting on you in the newest round, each with its thread |
| `lookover reply <finding> <claim> <text>` | Answers a finding on its thread: `fixed`, `wont-fix`, `disputed`, `deferred` or `question` |

They take `--pr N` and `--app SLUG` (by default `LOOKOVER_APP`, else the data folder's App, else the shared App); `wait` and `feedback` take `--json`. Their exit codes and the loop are in [Your coding agent](/docs/coding-agent/).

## The data folder

Lookover keeps everything in one data folder:

- `%LOCALAPPDATA%\Lookover` on Windows;
- `~/Library/Application Support/Lookover` on macOS;
- `~/.local/share/lookover` on Linux, or `$XDG_DATA_HOME/lookover` when that is set.

Every command takes `--home=<folder>` for another one, in one word, before or after the verb: `lookover --home=<folder> open`. `LOOKOVER_HOME` does the same for every command run in that environment.
