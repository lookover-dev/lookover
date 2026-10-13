// @lookover/process: OS process trees (ADR 0012, ADR 0033).
// The decision it hides: how a program is run contained, held to its limits, killed with everything it
// spawned, and found again after a crash. On Windows every start gets a Job Object with kill-on-close; on
// POSIX every start gets its own process group (setsid). That seam, `Supervisor` in `supervisor.ts`, is
// internal: `engines` runs the CLIs and `retrieval` runs git through `ProcessRunner` of @lookover/contracts
// and never learns which it is.
// Interface: `createProcessRunner({ registryFile })` returns the `ProcessRunner`. `start(invocation, limits)`
// runs `executable` by absolute path, never through a shell, with `args` as a list, `env` as the whole
// environment and `stdin` written then closed; it never throws (a program that can't start ends with
// `failed_to_start`, the reason in `stderr`, `pid` 0). `result` settles when the whole tree is gone: a
// program that exits leaving grandchildren has them killed first. One the kill can't reach (on POSIX, a
// grandchild that left the group with setsid and still holds stdout) no longer holds the result: a second
// after the program's exit the pipes are dropped and the result settles. `wallClockMs` counts from start, `idleMs`
// from the last byte written to stdout or stderr (also from start); each ends the run with its name. They
// count on `timers` (`now`, `after`), the real clock unless a test passes its own and moves time by hand.
// `kill()` ends it with `killed` and does nothing once the program has exited. `exitCode` is the program's
// own only when `end` is `exited`, null otherwise (null too for a POSIX signal death). `start`'s third argument,
// `onStdout`, gets each chunk of stdout as it arrives, in order, before `result` settles (ADR 0055): joined, they are
// `result.stdout`; a chunk may end mid-line, and splitting lines is the caller's.
// The registry: `registryFile` holds, as a JSON array of `{ pid, created }`, every process started and not
// yet ended, `created` being the OS's own creation time of that pid (a Windows FILETIME, a Linux
// `/proc` start tick, `ps lstart` elsewhere). `sweepOrphans()` kills the tree of every entry whose pid still
// runs with that same creation time (a reused pid is left alone), drops every entry, skips what this runner
// is running itself, and returns how many it killed. On Windows the OS already killed a crashed run's trees
// (kill-on-close), so the sweep terminates only a tree root it still finds; on POSIX it kills the group.
// Ordering: `sweepOrphans()` once, when a program using the registry starts, before its first `start` (the
// service's demo and live wirings do); a process is in the registry from its start until its tree is gone, so
// `result` settles only after its entry is dropped. Runs started on one runner are independent of each other.
// Error modes: `start` never throws and `result` never rejects: a program that can't start, or one the
// registry can't record (it is killed at once: it would outlive a crash unseen), ends with `failed_to_start`,
// the reason in `stderr`, `pid` 0. An entry the registry can't drop at the end is left for the next sweep, which
// finds its pid gone or reused. `sweepOrphans()` rejects with the file system's error when the registry file
// can't be read or written: a data folder Lookover can't use.
// The second entry, `@lookover/process/terminal` (`terminal.ts`), is a start outside all of this: the
// sign-in terminal of ADR 0047, visible, uncontained, never registered, never killed. Nothing here reaches it.
// The third, `@lookover/process/background` (`background.ts`), starts the service itself out of the terminal, and
// opens the browser on its link, for `lookover start` (ADR 0054): uncontained too, never registered, never killed.
// It must never know: what the program is (claude, codex, git), Lookover's rules, the service, the UI.
export { createProcessRunner, type ProcessRunnerOptions, type Timers } from "./runner.ts";
