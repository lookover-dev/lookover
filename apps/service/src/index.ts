// @lookover/service: the Lookover service (ADR 0010, ADR 0028, ADR 0033, ADR 0038, ADR 0039, ADR 0043).
// The decision it hides: how the UI reaches the truth, and what each wiring of the service is made of. The entry offers
// two wirings, demo (`startDemoService`: a scenario of `SCENARIOS` played by the demo driver on the scripted fakes, ADR
// 0046, `lookover serve --demo --scenario=<id>`) and live (`startService` on `liveAdapters`, below); `runService` (what
// `lookover serve` calls with the configuration `readConfig(argv, system, self)` read: `--demo`, `--live`, or neither, the
// program, ADR 0054, on live mode's real adapters guarded by its live config when it has one, its data folder the user
// profile's by default, making no one-time link at start, `openUrl` null, serving the web app only when the program's
// build made it) and `bun run live` pick one, and everything inside takes its ports as parameters. `VERSION` is
// Lookover's version, written once.
// `lookover(argv, deps)` is the one `lookover` command (ADR 0054; `main.ts` runs it on this machine, from a clone as
// `bun run lookover`, or the compiled binary `bun run build` makes, which carries the web app). Its verbs:
// - `serve`: the service in this terminal until Ctrl+C or a signal (null once it serves); `serve --background` the
//   same, printing nothing, its lines in the log only.
// - `start`: `serve --background` started out of the terminal (`BackgroundPorts.startServe`), or the service already
//   serving the data folder found, then what `open` does; the program's start refuses a clone whose web app wasn't
//   built for it (`cloneWebBuild`).
// - `open`: a one-time link minted on the running service (`API.link`, two minutes, once) and the browser opened on
//   it; `--no-open` prints it.
// - `status`: running, starting or stopped, where, the data folder, version, process, and whether it starts at login
//   (`--json` for a program).
// - `stop`: the stop asked over the API (`API.stop`: the service answers, then stops as Ctrl+C would), then the
//   instance lock waited for; after 30 s, only the process `instance.json` named when it was asked is killed.
// - `wait`, `feedback` and `reply`: the agent's, handed to `agent-cli`'s `run` with `--home=` taken out and `--app
//   <slug>` added from the data folder's `github/app.json` (`--home=`, else `LOOKOVER_HOME`, else the profile's) when
//   neither `--app` nor `LOOKOVER_APP` names the App.
// - `help` (also `--help`, `-h` or no word) and `--version`.
// `start`, `open` and `stop` reach the service as the UI does: the data folder's session cookie and the exact Origin.
// Exit codes, one table for the command: 0 done or running, 1 error (a start that failed, a service that didn't stop,
// git not on the PATH, a live config missing), 2 usage (a verb or an option it doesn't have, `--home <dir>` or any
// valued option in two words, two modes), 3 not running (`status`, `open`; `stop` exits 0 then, nothing is left
// running). `wait`, `feedback` and `reply` keep `agent-cli`'s own (0, 1 and 2 the same; 3 to 10 what the review asks
// of the agent), documented in its SKILL.md. `runService(config, deps)` first opens the log (`openLogSink`, ADR 0054:
// `<home>/logs/lookover-YYYY-MM-DD.log` by the local day, each line stamped in local time with its offset, files older
// than 30 days removed at start and when the day changes, `<home>` and `logs/` made user-only until a start has; every
// line through one filter removing the secrets registered with `secret` and anything shaped like one: GitHub tokens,
// private key blocks, JWTs, `Authorization` values, `token=` in a URL, a URL's password), through which go every line
// it prints (printed as the file keeps it, but for the URL to open, printed whole and kept filtered), the room's `log`
// (`options.logSink` of both starts, which also registers the session's secret and its link's token; every event
// that changes a review, a pause or an engine goes there as one line, worded by `logLineOf(event, before)` from the
// state before it, ADR 0055, with a line per job a restart recovered and two for a stop: who asked, then stopped;
// a line of several lines, as the start banner, is stamped line by line; the sink reads back its tail, today's last
// 200 lines topped up from yesterday's, and hands each new line to its subscribers, which the API serves as
// `LookoverApi.logs` and an unnumbered `log` message on every event stream, ADR 0055; in demo mode with `--frozen`,
// every line is stamped at that instant), GitHub's secrets
// (`LiveOptions.secret`, given to `@lookover/github`'s `secret`), an error no API route expected (written, the request
// answered 500) and an uncaught error or rejection (written, then the program exits 1); then it takes the data
// folder's instance lock (one service per data folder, ADR 0054: held, the start is refused with `InstanceHeld` naming
// the service from `instance.json`; `probeInstance(home)` says "held" or "free" without taking it;
// `takeInstance(home, userOnly)` takes it alone), starts the configured wiring (live mode and the program under the
// machine's live lock: one held elsewhere is printed and the process exits 1) on the port kept in `<home>/port` when it
// can be bound, else any free one, writes `<home>/instance.json` (process, port, address, version, since; user-only)
// and the port kept, writes the announce file whole (a start that fails once the service serves stops it and lets both
// locks go), prints the URL to open, and on SIGINT or SIGTERM stops the service, removes `instance.json`, lets both
// locks go and exits 0; `deps` gives it the clock, where it prints, the process (its signals, exit and id) and, for a
// test, the home the live lock is taken in, the live adapters, the user-only step and start at login's port. Both locks
// are OS-held (a SQLite file in exclusive locking mode, released by the system however the process ends, never a
// process id). Start at login (ADR 0054) is a port, `LoginItem` (registered with this command, register, unregister):
// the program without a live config registers `config.atLogin` (`loginCommand`: `lookover start --no-open` as `lookover` runs, `selfCommand`, by absolute
// paths, `--home=` unless the profile's folder) on the machine (`osLoginItem`: the `HKCU` `Run` value `Lookover` through
// `reg.exe`, a LaunchAgent, an XDG autostart entry), which refuses to be built under `bun test` but for `bun run live`'s
// `lookover-dev-` values (`windowsLoginItem`, `runValues`); every other wiring the room's fake (`memoryLoginItem`). The
// choice is on until the owner turns it off; once the setup is done the room makes the registration match it, at start,
// at the setup's finish and on each `service.startAtLogin` (refused with the machine's reason, the choice kept), and
// the snapshot's `service.startsAtLogin` says what the machine says, `service.loginItem` whose it is (`os` for the real
// one and demo mode, which plays the program; `memory` for live mode and a guarded program). `lookover status` says it too.
// Your coding agent (ADR 0058) is two ports beside it, `CommandPath` (reachable, add, remove: `lookover` on the PATH
// through a folder of Lookover's own) and `SkillFolders` (read, install, remove: the `lookover-review-loop` skill in
// Claude Code's and Codex's folders), each with a memory fake (`memoryCommandPath`, `memorySkillFolders`, with
// `refuse`). The unguarded program's binary reads and writes the machine's PATH (`osCommandPath`: Windows' user `Path`
// through `reg.exe` and a launcher, `~/.local/bin` elsewhere; refused under `bun test`), every other wiring the fake;
// an npm install's (`programSelf`: `LOOKOVER_LAUNCHER` set, ADR 0061) only reads whether npm's shim of its launcher
// comes first (`npmCommandPath`, `isNpmShim`), offers nothing, and is named `lookover` everywhere.
// The skill's real adapter writes `SKILL.md` under the user's home (`userSkillFolders`, refused under `bun test`;
// `homeSkillFolders` on a scratch home): the program's unguarded as `lookover-review-loop`, live mode's and a guarded
// program's as `lookover-dev-review-loop` (`DEV_SKILL_NAME`), demo mode on the fake. At start, Lookover's own skill
// of another version is written again. The skill's text is `packages/agent-cli/skill/SKILL.md` with Lookover's
// command in its spots (`skillCommandLine`: one line Git Bash runs as it is and PowerShell with `&`). The room reads
// both at start and
// on each `agent.path`, `agent.skill` and `agent.check`, sends `service.changed { agent }` when the machine says
// otherwise than the UI, and Lookover's command with it (`lookover` once the PATH reaches this executable); the
// skill is written by one renderer (`renderSkill`), stamped with the version and the absolute command, and whose a
// skill is (ours, another Lookover's, not Lookover's) is read from that stamp. A refused write refuses its command
// with the machine's reason (500); a clone has no PATH offer, an agent not found no skill.
// The person's own `gh` (ADR 0059) is a port, `Gh` (who it is signed in as, the organisations it admins, one
// organisation's membership; every read answers: `missing`, `signed-out`, or `unanswered` with why), read only: the
// program and live mode run the real one (`osGh`, `ghCli`: found as `lookover` on the PATH is; `gh api`
// with `GET`, a time limit, no prompt, the engines' allow-listed environment; refused under `bun test` unless given a
// scripted command or only folders of the test's own to search, or for `bun run live`'s suite), demo mode testkit's `memoryGh`; `runService` wires it
// (`ProgramDeps.gh`), the room holds it (`RoomOptions.gh`) and reads it on `gh.check` and on "Create it on GitHub" for
// an organisation (`Connection.gh` shows the answer), and, on an organisation's App, for the person's membership at
// start, every hour and on `gh.check` (no longer a member: the cause `not-a-member`, reviews stop); never for your
// own account.
// Inside, the service is a server
// (`Bun.serve`, the session, the API and its event streams, on its own timers) over one engine room (the store,
// the snapshot, the queue, the poller, the runs, the checks, the reactions, the owner's dismissals ("This finding is
// wrong", ADR 0052: refused while a round of the change runs, posted outside any round, resumed after a restart),
// the event log, and the room's clock and timers, ADR 0046): the API reaches the current room through one accessor, so a scenario load can build a
// second room and swap it in while the server and every session stay up.
// Interface: `startService(options)` opens the store in the data folder, reads the owner's App (`options.github`, ADR
// 0053: `live.json`'s as given, else the data folder's App store; with none, the setup shows and nothing is listed),
// and, once the setup says it is installed, the repositories its installation lists, cut to the allow-list when one
// is given (two of one name are refused); checks the engines' health, records its start as the first event, forgets
// the repositories the installation no longer lists, lists the open changes of each one it watches (one repository
// refused is logged, the start failing only when every one is or the installation is), and serves the API on
// 127.0.0.1. The owner is the App's owner and the bot its `<slug>[bot]`; the snapshot's connection carries the App
// (its id, slug and owner's login) and its installation's id, and Run checks how its key is kept. While the setup
// waits for the install, the installation is read every 4 s ("nothing granted" until it lists a repository, then
// every one switched on and the step moved on); once installed, its repositories are listed every 5 minutes and on
// "Reconnect": one added is polled at once (`repo.added`, switched on), one gone leaves (`repo.removed`, its jobs
// cancelled, a running one stopped, its unsent posts dropped; said departed in the snapshot until it is added again,
// when it starts with no waiting job, or dismissed with `repo.dismiss`, ADR 0059). An App
// created or given while the service runs is adopted without a restart (the room's `github.adopt`).
// `startDemoService(options)` does the same on a scenario's room (`scenarioOf(id)`): a fresh numbered folder under
// `<home>/rooms` (the old ones swept, their last event number carried on, so a tab from before reloads), the fake
// world built from the scenario, its seed played with the demo clock advanced through it (a seed whose review
// fails rejects with the job's failure), the rest of its script armed on the clock, which then stands still at
// `frozen` or flows with the real time. It then polls each repository by itself, one after the other (ADR 0043,
// ADR 0053): each every 10 s while a review of one of its changes is asked, waits or runs, or was posted in the last
// 30 minutes, every 60 s otherwise, on `options.timers`; a rate-limited listing waits, for every repository, until
// GitHub's reset time, which the connection's `limitUntil` shows. What a poll sees becomes events and jobs, each through `core.intake` with
// the repository's switches (the defaults: on open yes, after every push no): a change opened or a draft marked ready
// is reviewed (`change.opened`, trigger "opened"); another author's is recorded skipped, its check saying why (ADR
// 0016); a push is `change.pushed` with the commits GitHub counts, moves the waiting job to the new head, and asks for
// a review only with the switch on; a change no longer listed is `change.closed`, its waiting job cancelled (a running
// one finishes); the owner's `/lookover review` comment on an open pull request (a draft or another author's too) asks
// for a review of its head, trigger "comment", answered with 👀 once recorded and 🚀 once its round is posted (other
// comments, and anyone else's, ask nothing). The first listing of a repository (a fresh data folder) asks for nothing:
// what was open before is only shown; a listing refused as rate limited at start is the same wait, and the service
// starts. The API: the snapshot at `GET /api/v1/snapshot`, the events at `GET /api/v1/events` (server-sent events,
// the sequence number as the event id, `Last-Event-ID` or `?after=` replays what a UI missed from the last 1,000, or
// sends `reload` when it is gone or from before this start; a quiet stream says `keepalive` every 15 s, as an event
// the browser sees, carrying the service's `now` as `{ at }` so a tab follows the room's clock between events and
// never runs ahead of one standing still, timed by the server's own timers, `options.serverTimers`, the real ones
// by default), the commands at `POST /api/v1/commands` (JSON, parsed with Zod; `refresh` polls now;
// `review.request` records the change's job and hands it to the queue, answering once it is recorded: `store`'s
// take, in one transaction, offers the waiting jobs oldest first to `core`'s `takeDecision` (the finder the round
// plan names: the engine that didn't write the change, read from its commits' `Co-authored-by` trailers and its
// branch prefix, never Codex on another author's change, which is skipped where only Codex may review, ADR 0044;
// `mayStart` deferring the job while paused or that engine is missing, signed out or at its limit, one run per
// engine, and deferred "connection" while the poller shows GitHub disconnected, ADR 0047), after a request, after
// a poll that saw something (the connection back included), after a run ends and every 60 s
// while a job waits on an engine,
// so a deferred job starts by itself once its reason clears (a run that finds its engine signed out or at its
// limit defers its job the same way, at its limit until the reset its run read, ADR 0055; a deferred job asked
// for again is only put back in the queue, ADR 0042;
// a change has one waiting job, which a request joins, and a request while its job runs queues a follow-up that
// starts once the run ends, #65), and a job left running by a stopped service runs again at the next start, once,
// unless its run had reached publishing, else fails, "the service stopped" (#62); `service.pause` (for an hour,
// until tomorrow or until resumed) and `service.resume` keep the pause in the store and send it as
// `service.changed`: while it holds nothing starts, a review asked for waits deferred "paused", a running one
// finishes, and the resume, or a timed pause's end with nobody asking, takes the jobs it held (ADR 0040); the pause
// outlives a restart; the tick and the pause's end wait on `options.timers` too; the job's run (ADR 0044) is
// prepare (one at a time per repository) → find (once, or at depth Deep twice, the second pass on the other engine,
// then merged) → confirm (one session on the confirmer for the new candidates, its `confirming` step skipped when
// none is new or none is planned, at Quick) → reconcile → the round saved with the posts it owes, the outbox, in
// one write, its engine then free → publish from the outbox, each step stored and sent as an event; a session
// that answers signed out or at its limit shows its engine so; the developer drawer's clock verbs, `demo.clock`
// (the room's clock flows with the real time at a speed, or stands still), `demo.advance` (by a time) and
// `demo.step` (to the next timer), move the room's one clock, `options.demoClock`, which demo mode passes as the
// room's `clock` and `timers` too (ADR 0046), so the poll, the tick, a pause's end and the fakes' durations fire
// in order, each advance or step sent as one `clock` event, numbered like any; in live mode the room has no demo
// clock and the three answer 501; the drawer's `demo.inject` makes a fault happen on the fake world now (an engine
// signed out, missing, at its limit or failing its self-test, GitHub refusing or asking to wait, a pull request
// opened by the agent or someone else, pushed to or closed), 409 when the story has nothing left for it, and
// `GET /api/v1/demo` lists the scenarios, the one loaded, the clock and the faults; `demo.load` builds the named
// scenario's room on a fresh folder, its events numbered after the current room's, plays its seed and only then
// stops the current room and swaps the new one in, with one `clock` event, under the same server and session, so
// every open stream is told to reload and a tab reconnecting with a number from the old room too; meanwhile
// commands answer 409 "loading" and a new stream waits; a seed that fails keeps the old room and answers 500 with
// the fixture's error, an id the catalogue hasn't 404; in live mode the load and the fault answer 501 and the
// listing 404 (ADR 0046); `connection.reconnect` lists now (a listing GitHub refuses as unauthorised or
// unavailable, whoever asked, shows the connection `disconnected` and one that answers `connected`, a rate limit
// only `limitUntil`, ADR 0047; "Review now" meanwhile still records its job, on the last listing's head);
// `service.runChecks` sends the checks running, reads both engines' health again and sends the items as data
// (each engine, the connection, the service, the data folder's free space, the version never checked against a
// newer one), 409 while they run; `service.unlock` sends `unlocked: true` once; `engine.reroute` sends every job
// deferred on that engine whose change the other engine may review (`core.stepIn`: the repository's reviewers
// allow it, never Codex on another author's change) to the other one, kept by the store as the finder its take
// plans with until the job ends, then takes, so each starts on it or waits for it, and the change's next job plans
// as usual (ADR 0047); a job sent deferred on an engine says which engine may step in for it, `stepIn`, by the
// same rule, computed each time it is sent; `setup.goto`, `setup.chooseRepos` (each watched repository's switch,
// then the first review's step), `setup.finish` and `repo.setEnabled` (404 for a repository not watched) are kept by the
// store and sent as `setup.changed` / `repo.changed`, the furthest step reached kept; a start on a data folder
// whose setup nobody wrote writes it (set up in live mode until onboarding; the scenario's in demo mode, where no bot installed means
// no connection and no listing); `connection.createApp` only records where the App is made (your own account, or an
// organisation the person's `gh` lists as theirs to admin, ADR 0059) and that the setup waits for it (409, why in
// `createApp`, once an App is kept, under `live.json`, or as `gh` says): the manifest flow's pages make it (`app-flow-pages.ts` over
// `app-flow.ts`, ADR 0053; in demo mode on GitHub's fake pages), the install then waited for every 4 s, the step
// moved on to the repositories only if the owner is still on GitHub's; a request (`review.request` or `/lookover
// review`) in a repository switched off is recorded as a skip, "repo-off", its check saying why, unless the change
// has a job waiting or running, which it joins (ADR 0047); `engine.signIn` opens the vendor's own login, `options.signIn` (ADR 0047: in live mode
// `liveAdapters` wires it as a visible terminal on the command `engines` names, started outside the runner from
// the user's home folder; in demo mode the scripted engine signs itself in 5 s on), sends `engine.changed
// { signingIn: true }`, then reads the engine's health every 5 s on the room's timers for up to 10 min, what
// changed sent (a run's signed-out or limit hold still standing over a ready health), and ends the watch with
// `signingIn: false` on any state but signed out (ready also takes, so a review deferred on it starts) or at
// 10 min; 409 while one is pending for that engine, 500 with why when the login didn't open (the engine not
// installed, no terminal program), nothing shown then; a sign-in pending when a service stops is cleared by the
// next start; `settings.set`, `repo.setSetting` and `repo.resetSetting` (ADR 0049) write the settings files in the
// data folder, `options.home`, whose root also holds the store (ADR 0053): the owner's defaults in `settings.yaml`
// there, each watched repository's own values in `<owner>/<name>/settings.yaml`, through `options.settingsFiles`
// (`diskSettingsFiles(root)` unless given: a temporary file then a rename, user-only, never outside the root;
// `repositorySettingsFile(repo)` is null for a name that must not become a path, or for an owner named as one of
// the service's own folders at the root, such as `runs`), one change after the other, each then sent as
// `settings.changed` naming the repository when what applies to it moved; a value that isn't one its key accepts
// answers 400, a repository not watched 404, a file that doesn't read or can't be opened 409 with its error as
// `invalid` (never written over; Run checks names it too, and it never stops a start), a write that failed 500 with
// `unwritten: { file, why }` (why `held-open` when Windows refused the rename, else `other`); at start the files are
// read, and what moved since the log's last word is sent; "Create it on GitHub" records that the setup waits for the
// App, the page it opens making it, and is refused 409 under `live.json` or once an App is kept). It returns the URL to open the app with, which works once; the cookie it sets is the data folder's
// and outlives the start, so an open tab catches up after a restart.
// Invariants: the truth is in SQLite, and every change to it is sent as a numbered event, one more than the
// last (ADR 0038, across restarts too); the snapshot is the store's events applied with `apply`, once at start
// and then each as it is sent, so it equals what a UI that followed them holds, and serving it reads nothing;
// one service per data folder, since that copy follows only the events this service sends. The queue and the
// run decide from the store's handles (the open changes, the jobs, the pause), each repository's settings (as its
// files said them last: the one exception to the truth in SQLite, ADR 0049) and the engines' states as the UI's copy holds them, never from a replay of
// the event log, so a decision costs the same whatever its length (#64). A UI whose number is from before this start is
// told to reload, since what a start fixes (since when it runs, the engines' health) is in no event; a request without
// the session cookie, from another origin or site, or for another host is refused; no CORS header is ever sent; every
// response carries the content security policy, which bites on the built app the program and the binary serve
// (in development Vite serves it, ADR 0010).
// Ordering: the live wiring sweeps the process registry's orphans before it hands its ports over (`liveAdapters`;
// demo mode spawns nothing), so nothing a crashed start left runs beside a new job. `startService` then builds the room: opens
// the store (or takes the open one it is given), asks both engines' health, records its start as the next event, lists
// the changes and the comments (what changed, or was requested, while it was stopped is asked for), puts back in the
// queue or fails the jobs a stopped service left running and takes the next job, starts the poll's loop; and only then
// serves. `stop` stops the server first, so no request reaches a closing store, waits for a load under way, then
// stops the room (the poll, the queue, the checks' last writes, the reactions, the store). Polls
// run one at a time, whoever asks (the loop, `refresh`, `review.request`, a scenario's moves). The queue starts
// the oldest waiting job whose engines are free, one run per engine (a run holds its finder and its confirmer), and
// takes again when a run's round is saved and when it ends; within a run, prepare → find → confirm → reconcile →
// save → publish, each run step (preparing, finding, confirming, publishing) sent as an event before its work
// starts, publishing in the write that saves the round. A run a stopped service left at publishing goes on with
// its posts at the next start; nothing is found again.
// Error modes: `startService` rejects when the store won't open (a data folder from a newer Lookover: reset it),
// when the host won't list at start (its `HostError`; a rate limit only waits, and the service starts), when the
// session secret can't be written in the data folder, or when the port is taken. Once serving, nothing a job
// meets after the queue took it reaches the caller: it ends deferred or failed, with its reason on the job. Before
// that, a host that won't list on `refresh` or `review.request` answers 502 with the failure code, and what the
// store throws reaches the request, which gets no answer; a command that doesn't parse answers 400; a command with no
// row answers 501 (none today: in live mode only the demo verbs do, with nothing scripted to move). Live mode:
// `readLiveConfig` throws a plain `Error` holding `LIVE_CONFIG_HELP` for a config that is missing or of another
// shape (one repository listed twice, say), and takes a `watch` it no longer reads, naming it in `ignored` for the
// start to print `WATCH_IGNORED` once (`runService`, `bun run live`), its value never read; `liveAdapters` rejects with
// the file system's error when the key file or the process registry can't be read; `startService` never rejects for
// GitHub (ADR 0053): the App not installed, a key it refuses, GitHub down or a key Lookover kept that no longer opens
// start the service all the same, the connection showing the cause;
// `acquireLiveLock({ folder })` throws `LiveLockHeld` naming the holder and its data folder, or SQLite's error when the lock file
// can't be opened.
// Live mode (ADR 0039, ADR 0053), for `lookover serve --live` and `bun run live`: `readLiveConfig(path)` reads the live
// config file (the repositories live mode may use, the allow-list cutting what the installation lists; an optional
// `fork`, the owner's fork of the sandbox for `bun run live`, never listed there and never read by the service; an optional
// App: its id and its key's path, the data folder then set up at once; without it, the data folder's App, or the
// setup's first step; an optional `organisation`, an organisation's App and its sandbox, whose `repositories`, when
// given, make `servedLiveConfig(config, path)` the organisation's App on them (ADR 0060), the key file refused when
// missing, with the one line the start prints then; `liveConfigPath(home)` is its place in a data folder); a live
// service keeps one store, one process registry
// and the mirrors at the data folder's root, and each repository's folder keeps only its `settings.yaml`
// (ADR 0049). `liveAdapters(options)` wires the real GitHub App, `claude`
// and `retrieval` on it (its sign-in `terminalSignIn(engines, session, open?)`: the engine's login in a terminal
// with the engine's allow-listed environment only, ADR 0048, the terminal given the desktop session), and `acquireLiveLock()` takes the machine-wide lock in the
// user's home (one real review at a time across worktrees and the program; a second run gets `LiveLockHeld` naming the holder).
// `appStore({ home, keychain })` keeps the GitHub App (ADR 0053): its record in `github/app.json`, its key in
// `github/app.<entry>.key` encrypted under a data key in the keychain port's entry (`osKeychain(timers)` over the
// OS's, bounded by a timeout; `memoryKeychain()` for tests and demo mode), or unencrypted in `github/app.<id>.pem`
// when the keychain can't, which `read()` and `write()` report as the key's protection (`read()` naming that file
// as `fallback`); each file user-only (on Windows its access list, `icacls`; tests inject `userOnly`); a key that no
// longer opens reads as `lost`. One store per data folder, in one process: its reads and writes take turns.
// `signInStore({ home, keychain })` keeps the sign-in to the shared App the same way, by the one sealing (ADR 0066):
// its record `github/sign-in.json` names the person, the tokens sealed in `github/sign-in.<entry>.key`, or in
// `github/sign-in.<id>.token` when the keychain can't; `keeper` is the adapter's `SignInKeeper` over it. Its folder is
// the data folder unless the live options name another (`LiveOptions.signIns`).
// It must never know: the words the screens say (its JSON errors are for the console), the rules of `core` (it
// calls them), or which wiring a program chose (the service itself sees only ports).
// Exports: what `scripts/` uses (the live suites, `eval`, `build`), and what this package's own tests drive, since
// they reach it through this entry alone (`scripts/check-deps.ts`, ADR 0033): the command and its ports (`lookover`,
// `BackgroundPorts`, `Self`, `serveCommand`, `webBuildOf`, `cloneWebBuild`), `runService` and its pieces
// (`readConfig`, `loginCommand`, `probeInstance`, `takeInstance`, `openLogSink`, `logLineOf`, the login items, the web
// files).
// The code inside uses each of them too, so none moves to test support (`*.test-support.ts`), which reaches nothing
// past this entry either. `main.ts` and the binary's generated entry import their files directly.

export { REFUSED_PAGES, type RefusedPage } from "./app-flow-pages.ts";
export {
  type AppRead,
  type AppStore,
  appStore,
  type LostWhy,
  type Membership,
  type StoredApp,
} from "./app-store.ts";
export type { BackgroundPorts, ServeStarted, WebBuild } from "./background.ts";
export { type LookoverDeps, lookover } from "./command.ts";
export {
  type CommandPath,
  isNpmShim,
  linkCommandPath,
  type MemoryCommandPath,
  memoryCommandPath,
  npmCommandPath,
  osCommandPath,
  windowsCommandPath,
} from "./command-path.ts";
export {
  type Config,
  loginCommand,
  lookoverCommand,
  readConfig,
  realSystem,
  type System,
  selfCommand,
} from "./config.ts";
export { buildDemoRoom, type DemoRoom } from "./demo/driver.ts";
export type { Scenario } from "./demo/scenario.ts";
export { SCENARIOS, scenarioOf } from "./demo/scenarios.ts";
export { HANDED_APP, MADE_APP } from "./demo/world.ts";
export {
  ghCli,
  osGh,
} from "./gh.ts";
export type { GitHubSide, HostPorts } from "./installation.ts";
export { InstanceHeld, probeInstance, takeInstance } from "./instance.ts";
export {
  boundedKeychain,
  KEYCHAIN_SERVICE,
  type Keychain,
  KeychainUnavailable,
  type MemoryKeychain,
  memoryKeychain,
  osKeychain,
} from "./keychain.ts";
export { ghPerson, type LiveAdapters, type LiveOptions, liveAdapters, terminalSignIn } from "./live.ts";
export {
  LIVE_CONFIG_HELP,
  type LiveApp,
  type LiveConfig,
  type LiveConfigWithApp,
  type LiveOrganisation,
  liveConfigPath,
  readLiveConfig,
  servedLiveConfig,
  WATCH_IGNORED,
} from "./live-config.ts";
export { acquireLiveLock, type LiveLock, LiveLockHeld } from "./live-lock.ts";
export { flowLines, logLineOf, membershipLines } from "./log-lines.ts";
export { type LogReader, type LogSink, openLogSink } from "./log-sink.ts";
export {
  DEV_VALUE_PREFIX,
  type LoginItem,
  launchAgentLoginItem,
  memoryLoginItem,
  osLoginItem,
  type RegAnswer,
  runValues,
  windowsLoginItem,
  xdgLoginItem,
} from "./login-item.ts";
export { realReg } from "./reg.ts";
export { DAY_MS } from "./retention.ts";
export { buildRoom, type Room, type RoomOptions } from "./room.ts";
export {
  cloneWebBuild,
  type Printer,
  type ProgramDeps,
  type ProgramProcess,
  runService,
} from "./run-service.ts";
export { programSelf, type Self, serveCommand, webBuildOf } from "./self.ts";
export type { DemoServiceOptions, RunningService, ServiceOptions } from "./service.ts";
export { startDemoService, startService } from "./service.ts";
export { settingsChanged } from "./settings-changed.ts";
export { diskSettingsFiles, repositorySettingsFile, SettingsUnwritten } from "./settings-files.ts";
export { skillCommandLine } from "./shell-line.ts";
export type { SignInOpened, SignInOpener } from "./sign-in.ts";
export { type SignInRead, type SignInStore, signInStore } from "./sign-in-store.ts";
export { renderSkill, skillStampOf } from "./skill.ts";
export {
  CODING_AGENTS,
  DEV_SKILL_NAME,
  homeSkillFolders,
  type MemorySkillFolders,
  memorySkillFolders,
  SKILL_NAME,
  type SkillFolders,
  userSkillFolders,
} from "./skill-folders.ts";
// A data folder set up: `bun run live`'s shared App path starts its run folder so, as live.json's App does (ADR 0066).
export { SET_UP } from "./snapshot.ts";
export { REAL_TIMERS, type Timers } from "./timers.ts";
// A file made user-only (an ACL on Windows, 0600 elsewhere): the App store's own, for a key file a dev script writes.
export { makeUserOnly } from "./user-only.ts";
export { VERSION } from "./version.ts";
export { carriedWebFiles, diskWebFiles, type WebFiles } from "./web-files.ts";
