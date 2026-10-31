---
title: Updating and removing
description: How to update Lookover, turn off start at login, and remove it with everything it wrote.
---

## Update

Stop it first: on Windows the running program holds its file open, so npm can't replace it.

```sh
lookover stop
npm update -g lookover
lookover start
```

`npm update` updates the launcher and the executable together. The skill and start at login keep working: they name the executable's path, and an update keeps it. Lookover refreshes the skill at its next start when the version changed.

`lookover --version` says which version runs. Security fixes go to the latest 0.x minor only.

## Start at login

Lookover starts each time you log in. Settings › Start at login turns that off.

On Windows it is a value named `Lookover` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, which runs `lookover start --no-open`. A console window flashes for a moment at each login: that is the value starting Lookover. To see it:

```bat
reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v Lookover
```

On macOS it is `~/Library/LaunchAgents/dev.lookover.plist`; on Linux, `lookover.desktop` in `~/.config/autostart` (`$XDG_CONFIG_HOME/autostart` when that is set).

## Remove it

1. In Settings › Your coding agent, **Remove the skill**.
2. In Settings, turn off **Start at login**.
3. `lookover stop`, then `npm uninstall -g lookover`.
4. Delete Lookover's entry in your system's credential store. Its name is `key.entry` in `github/sign-in.json` when you signed in with GitHub, or in `github/app.json` with your own App, in the data folder (`lookover status` names the folder). With `"kept": "file"` there, there is no entry: the secret is a file in that folder. On Windows, `cmdkey /list | findstr lookover` lists the entries and `cmdkey /delete:lookover/<entry>` deletes one.
5. Delete the data folder.
6. Signed in with GitHub: on GitHub, under Settings › Applications › **Authorized GitHub Apps**, **Revoke** Lookover Dev. That ends your sign-in on every computer. Lookover Dev stays installed where it is, for your teammates; an owner uninstalls it from the account's **Installed GitHub Apps**. With your own App: delete the App if you no longer want it.
